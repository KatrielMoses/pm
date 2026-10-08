-- migrate:phase expand
-- Phase 4C (0B ADR-33, 0C AZ-33, 0D PL-35; ADR-0025; OD-32): documents and knowledge. Documents
-- are records in the core envelope (workspace- or brand-scoped, optionally attached to one project
-- or one task, nested as pages), with immutable content versions, registered references (links and
-- mentions), block suggestions, and append-only AI-source approvals. Access is the placement's
-- (brand or workspace level, the governing project chain, exact-record shares); no row here copies
-- anyone's access. No file storage, previews, live editing, search index, or notification delivery
-- (4E, 4D, 5A, 4B).

CREATE SCHEMA knowledge;
REVOKE ALL ON SCHEMA knowledge FROM PUBLIC;
GRANT USAGE ON SCHEMA knowledge TO app_rw, app_worker;

-- Block documents (version 2): an object with `v` = 2 and an ordered `blocks` array. The commands
-- enforce the configured bounds; these are the database's widest ceilings.
CREATE FUNCTION knowledge.valid_content(c jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT c IS NOT NULL AND jsonb_typeof(c) = 'object' AND c->>'v' = '2'
          AND jsonb_typeof(c->'blocks') = 'array' AND jsonb_array_length(c->'blocks') <= 5000
          AND octet_length(c::text) <= 2000000 $$;

-- ---------------------------------------------------------------------------------------------
-- Documents (DOC-001 to DOC-006, DOC-015, DOC-016): the envelope's typed row. The current content
-- is the current version's; title, state, owner, and review date are the document's own.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge.document (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  parent_document_id uuid,
  ancestor_ids uuid[] NOT NULL DEFAULT '{}',
  depth smallint NOT NULL DEFAULT 0,
  attached_project_id uuid,
  attached_task_id uuid,
  doc_type text NOT NULL DEFAULT 'page',
  title text NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  owner_membership_id uuid NOT NULL,
  review_due_on date,
  current_version_id uuid,
  current_version_number integer NOT NULL DEFAULT 0,
  rank text COLLATE "C" NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT document_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT document_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT document_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT document_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT document_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  -- Same workspace and scope as the parent; RESTRICT blocks purging a parent a live page still uses.
  CONSTRAINT document_parent_fkey FOREIGN KEY (workspace_id, scope_key, parent_document_id)
    REFERENCES knowledge.document (workspace_id, scope_key, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT document_project_fkey FOREIGN KEY (workspace_id, brand_id, attached_project_id)
    REFERENCES work.project (workspace_id, brand_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT document_task_fkey FOREIGN KEY (workspace_id, brand_id, attached_task_id)
    REFERENCES work.task (workspace_id, brand_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT document_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_attachment_exclusive CHECK (NOT (attached_project_id IS NOT NULL AND attached_task_id IS NOT NULL)),
  CONSTRAINT document_attachment_in_brand CHECK ((attached_project_id IS NULL AND attached_task_id IS NULL) OR brand_id IS NOT NULL),
  CONSTRAINT document_type_known CHECK (doc_type IN
    ('page', 'brand_brief', 'project_brief', 'sop', 'specification', 'meeting_notes', 'decision', 'release_notes')),
  -- A brand brief belongs to a brand itself; a project brief to a project.
  CONSTRAINT document_type_placement CHECK (
    (doc_type <> 'brand_brief' OR (brand_id IS NOT NULL AND attached_project_id IS NULL AND attached_task_id IS NULL))
    AND (doc_type <> 'project_brief' OR attached_project_id IS NOT NULL)),
  CONSTRAINT document_state_known CHECK (state IN ('draft', 'current', 'stale')),
  CONSTRAINT document_title_text CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND title = btrim(title)
    AND tenancy.valid_plain_text(title, 200)),
  CONSTRAINT document_depth_ceiling CHECK (depth BETWEEN 0 AND 16),
  CONSTRAINT document_ancestry_length CHECK (cardinality(ancestor_ids) = depth),
  CONSTRAINT document_root_shape CHECK ((parent_document_id IS NULL) = (depth = 0)),
  CONSTRAINT document_parent_is_last_ancestor CHECK (parent_document_id IS NULL OR ancestor_ids[depth] = parent_document_id),
  CONSTRAINT document_not_own_ancestor CHECK (NOT (id = ANY (ancestor_ids))),
  CONSTRAINT document_version_pointer CHECK ((current_version_id IS NULL) = (current_version_number = 0)),
  CONSTRAINT document_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT document_counts CHECK (current_version_number >= 0 AND version >= 0)
);
CREATE INDEX document_by_envelope ON knowledge.document (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX document_by_brand ON knowledge.document (workspace_id, brand_id);
CREATE INDEX document_children ON knowledge.document (workspace_id, parent_document_id, rank, id);
CREATE INDEX document_by_parent_scope ON knowledge.document (workspace_id, scope_key, parent_document_id);
CREATE INDEX document_roots ON knowledge.document (workspace_id, scope_key, rank, id) WHERE parent_document_id IS NULL;
CREATE INDEX document_by_project ON knowledge.document (workspace_id, brand_id, attached_project_id);
CREATE INDEX document_by_task ON knowledge.document (workspace_id, brand_id, attached_task_id);
CREATE INDEX document_by_owner ON knowledge.document (workspace_id, owner_membership_id);
CREATE INDEX document_by_creator ON knowledge.document (workspace_id, created_by_membership_id);
CREATE INDEX document_by_updater ON knowledge.document (workspace_id, updated_by_membership_id);
CREATE INDEX document_by_review ON knowledge.document (workspace_id, review_due_on) WHERE review_due_on IS NOT NULL;
CREATE INDEX document_by_version ON knowledge.document (workspace_id, current_version_id);

-- A page is in its parent's scope and attachment, and its ancestry is the parent's plus the parent.
-- Checked at commit so a subtree move or re-attachment can update every page at once.
CREATE FUNCTION knowledge.assert_document_placement() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  cur record;
  par record;
BEGIN
  SELECT id, workspace_id, scope_key, attached_project_id, attached_task_id, parent_document_id, ancestor_ids INTO cur
    FROM knowledge.document WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF cur.parent_document_id IS NULL THEN
    IF cur.ancestor_ids <> '{}'::uuid[] THEN
      RAISE EXCEPTION 'a root document has no ancestors' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT id, scope_key, attached_project_id, attached_task_id, ancestor_ids INTO par FROM knowledge.document
   WHERE workspace_id = cur.workspace_id AND id = cur.parent_document_id;
  IF NOT FOUND OR par.scope_key <> cur.scope_key
     OR par.attached_project_id IS DISTINCT FROM cur.attached_project_id
     OR par.attached_task_id IS DISTINCT FROM cur.attached_task_id
     OR cur.ancestor_ids <> par.ancestor_ids || par.id THEN
    RAISE EXCEPTION 'document placement is inconsistent with its parent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER document_placement
  AFTER INSERT OR UPDATE OF parent_document_id, ancestor_ids, depth, attached_project_id, attached_task_id, brand_id, scope_key
  ON knowledge.document DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION knowledge.assert_document_placement();

-- ---------------------------------------------------------------------------------------------
-- Versions (DOC-013, DOC-014): immutable content snapshots. A restore appends a new version.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge.document_version (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  number integer NOT NULL,
  title text NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  size_bytes integer NOT NULL,
  kind text NOT NULL,
  restored_from_number integer,
  template_key text,
  change_summary jsonb NOT NULL DEFAULT '{}',
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_version_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT document_version_number_key UNIQUE (workspace_id, document_id, number),
  CONSTRAINT document_version_document_fkey FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge.document (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT document_version_author_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_version_number_positive CHECK (number >= 1),
  CONSTRAINT document_version_title_text CHECK (char_length(btrim(title)) BETWEEN 1 AND 200 AND tenancy.valid_plain_text(title, 200)),
  CONSTRAINT document_version_content CHECK (knowledge.valid_content(content)),
  CONSTRAINT document_version_hash_format CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT document_version_size CHECK (size_bytes BETWEEN 1 AND 2000000),
  CONSTRAINT document_version_kind_known CHECK (kind IN ('save', 'restore', 'suggestion', 'template')),
  CONSTRAINT document_version_restore_shape CHECK ((kind = 'restore') = (restored_from_number IS NOT NULL)
    AND (restored_from_number IS NULL OR (restored_from_number >= 1 AND restored_from_number < number))),
  CONSTRAINT document_version_template_shape CHECK (template_key IS NULL OR (kind = 'template' AND template_key ~ '^[a-z_]{1,40}@[0-9]{1,4}$')),
  CONSTRAINT document_version_summary CHECK (jsonb_typeof(change_summary) = 'object')
);
CREATE INDEX document_version_by_author ON knowledge.document_version (workspace_id, created_by_membership_id);
ALTER TABLE knowledge.document
  ADD CONSTRAINT document_current_version_fkey FOREIGN KEY (workspace_id, current_version_id)
    REFERENCES knowledge.document_version (workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

-- Versions are append-only: the application can insert and read, never change or delete them.
CREATE FUNCTION knowledge.document_version_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RAISE EXCEPTION 'document versions are immutable' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER document_version_immutable BEFORE UPDATE ON knowledge.document_version
  FOR EACH ROW EXECUTE FUNCTION knowledge.document_version_immutable();

-- ---------------------------------------------------------------------------------------------
-- References (DOC-008, DOC-009): the links and mentions of the current content, rebuilt on save.
-- A reference grants nothing and is re-authorized for every viewer when shown.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge.document_reference (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  block_id text NOT NULL,
  position smallint NOT NULL DEFAULT 0,
  kind text NOT NULL,
  target_kind text NOT NULL,
  target_membership_id uuid,
  target_team_id uuid,
  target_record_id uuid,
  target_record_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_reference_document_fkey FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge.document (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT document_reference_member_fkey FOREIGN KEY (workspace_id, target_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_reference_team_fkey FOREIGN KEY (workspace_id, target_team_id)
    REFERENCES tenancy.team (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_reference_record_fkey FOREIGN KEY (workspace_id, target_record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_reference_kind_known CHECK (kind IN ('mention', 'link')),
  CONSTRAINT document_reference_block CHECK (char_length(block_id) BETWEEN 1 AND 64),
  CONSTRAINT document_reference_position CHECK (position >= 0),
  CONSTRAINT document_reference_target_shape CHECK (
    (target_kind = 'member' AND target_membership_id IS NOT NULL AND target_team_id IS NULL AND target_record_id IS NULL AND target_record_type IS NULL)
    OR (target_kind = 'team' AND target_team_id IS NOT NULL AND target_membership_id IS NULL AND target_record_id IS NULL AND target_record_type IS NULL)
    OR (target_kind = 'record' AND target_record_id IS NOT NULL AND target_membership_id IS NULL AND target_team_id IS NULL
        AND target_record_type IN ('task', 'project', 'brand', 'document')))
);
CREATE UNIQUE INDEX document_reference_unique_member ON knowledge.document_reference (workspace_id, document_id, kind, target_membership_id)
  WHERE target_kind = 'member';
CREATE UNIQUE INDEX document_reference_unique_team ON knowledge.document_reference (workspace_id, document_id, kind, target_team_id)
  WHERE target_kind = 'team';
CREATE UNIQUE INDEX document_reference_unique_record ON knowledge.document_reference (workspace_id, document_id, kind, target_record_id)
  WHERE target_kind = 'record';
CREATE INDEX document_reference_by_document ON knowledge.document_reference (workspace_id, document_id);
CREATE INDEX document_reference_by_member ON knowledge.document_reference (workspace_id, target_membership_id);
CREATE INDEX document_reference_by_team ON knowledge.document_reference (workspace_id, target_team_id);
CREATE INDEX document_reference_by_record ON knowledge.document_reference (workspace_id, target_record_id);

-- ---------------------------------------------------------------------------------------------
-- Suggestions (DOC-012): a proposed replacement of one block, against a base version and the base
-- block's hash. Applied only to an unchanged block; otherwise stale. Never grants access.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge.document_suggestion (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  block_id text NOT NULL,
  base_version integer NOT NULL,
  base_block_hash text NOT NULL,
  proposed jsonb NOT NULL,
  note text,
  state text NOT NULL DEFAULT 'open',
  author_membership_id uuid NOT NULL,
  decided_by_membership_id uuid,
  decided_at timestamptz,
  applied_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT document_suggestion_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT document_suggestion_public_id_format CHECK (public_id ~ '^dsg_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT document_suggestion_document_fkey FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge.document (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT document_suggestion_author_fkey FOREIGN KEY (workspace_id, author_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_suggestion_decider_fkey FOREIGN KEY (workspace_id, decided_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT document_suggestion_state_known CHECK (state IN ('open', 'accepted', 'rejected', 'withdrawn', 'stale')),
  CONSTRAINT document_suggestion_block CHECK (char_length(block_id) BETWEEN 1 AND 64),
  CONSTRAINT document_suggestion_base CHECK (base_version >= 1),
  CONSTRAINT document_suggestion_hash_format CHECK (base_block_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT document_suggestion_proposed CHECK (jsonb_typeof(proposed) = 'object' AND octet_length(proposed::text) <= 100000),
  CONSTRAINT document_suggestion_note CHECK (note IS NULL OR (char_length(btrim(note)) BETWEEN 1 AND 500 AND tenancy.valid_plain_text(note, 500))),
  CONSTRAINT document_suggestion_decided_shape CHECK (
    (state IN ('accepted', 'rejected')) = (decided_by_membership_id IS NOT NULL AND decided_at IS NOT NULL)
    AND (state = 'accepted') = (applied_version IS NOT NULL)),
  CONSTRAINT document_suggestion_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX document_suggestion_by_document ON knowledge.document_suggestion (workspace_id, document_id, state, created_at);
CREATE INDEX document_suggestion_by_author ON knowledge.document_suggestion (workspace_id, author_membership_id);
CREATE INDEX document_suggestion_by_decider ON knowledge.document_suggestion (workspace_id, decided_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Source approvals (DOC-017): an append-only fact that one version is (or is no longer) an approved
-- AI source. Only the latest row for a document counts, and only for the version it names.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge.source_approval (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  version_number integer NOT NULL,
  kind text NOT NULL,
  actor_membership_id uuid NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_approval_version_fkey FOREIGN KEY (workspace_id, document_id, version_number)
    REFERENCES knowledge.document_version (workspace_id, document_id, number) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT source_approval_actor_fkey FOREIGN KEY (workspace_id, actor_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT source_approval_kind_known CHECK (kind IN ('approved', 'revoked')),
  CONSTRAINT source_approval_note CHECK (note IS NULL OR (char_length(btrim(note)) BETWEEN 1 AND 500 AND tenancy.valid_plain_text(note, 500)))
);
CREATE INDEX source_approval_by_version ON knowledge.source_approval (workspace_id, document_id, version_number, created_at DESC);
CREATE INDEX source_approval_by_actor ON knowledge.source_approval (workspace_id, actor_membership_id);

-- A review request may name a document as its subject (4A hosts).
ALTER TABLE collab.review_request DROP CONSTRAINT review_request_subject_known;
ALTER TABLE collab.review_request ADD CONSTRAINT review_request_subject_known
  CHECK (subject_kind IN ('task', 'project', 'document'));

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE knowledge.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.document FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge.document
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE knowledge.document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.document_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge.document_version
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE knowledge.document_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.document_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge.document_reference
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE knowledge.document_suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.document_suggestion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge.document_suggestion
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE knowledge.source_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.source_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge.source_approval
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON knowledge.document, knowledge.document_version, knowledge.document_reference,
  knowledge.document_suggestion, knowledge.source_approval FROM PUBLIC;
GRANT SELECT, INSERT ON knowledge.document TO app_rw;
GRANT UPDATE (parent_document_id, ancestor_ids, depth, attached_project_id, attached_task_id, title, state,
  owner_membership_id, review_due_on, current_version_id, current_version_number, rank, updated_at,
  updated_by_membership_id, version) ON knowledge.document TO app_rw;
-- Versions and approvals are append-only; references are rebuilt from the content on every save.
GRANT SELECT, INSERT ON knowledge.document_version, knowledge.source_approval TO app_rw;
GRANT SELECT, INSERT, DELETE ON knowledge.document_reference TO app_rw;
GRANT SELECT, INSERT ON knowledge.document_suggestion TO app_rw;
GRANT UPDATE (state, decided_by_membership_id, decided_at, applied_version, updated_at, version)
  ON knowledge.document_suggestion TO app_rw;
-- The worker purges a purged document's content, and nothing else.
GRANT SELECT, DELETE ON knowledge.document, knowledge.document_version, knowledge.document_reference,
  knowledge.document_suggestion, knowledge.source_approval TO app_worker;
REVOKE ALL ON FUNCTION knowledge.valid_content(jsonb), knowledge.assert_document_placement(),
  knowledge.document_version_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.valid_content(jsonb) TO app_rw, app_worker;
