-- migrate:phase expand
-- Phase 4D (0B ADR-35, 0C AZ-35, 0D PL-37; ADR-0027; OD-30): collaborative editing. Live editing
-- changes a draft, never a version: a draft is the document's working block list (opened from the
-- current immutable version), edit sessions are ephemeral presence with an expiry, and the
-- operation log is the ordered, gapless record between checkpoints. A checkpoint appends one
-- ordinary 4C version (no row here is a version). No row here grants or copies anyone's access;
-- every request re-checks the document's own level. Nothing here is audited per operation: durable
-- content changes are audited as versions are saved.

-- ---------------------------------------------------------------------------------------------
-- Documents as file hosts (4C and 4E were built in parallel; each left this join to the later
-- integration). A file may hang on a document (brand-scoped or workspace-scoped), and a comment on
-- a workspace-scoped document may carry files, so the brand is optional for those two hosts.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE files.file DROP CONSTRAINT file_host_kind_known;
ALTER TABLE files.file ADD CONSTRAINT file_host_kind_known
  CHECK (host_kind IN ('workspace', 'brand', 'project', 'task', 'comment', 'document'));
ALTER TABLE files.file DROP CONSTRAINT file_host_shape;
ALTER TABLE files.file ADD CONSTRAINT file_host_shape CHECK (
  (host_kind = 'workspace' AND host_record_id IS NULL AND brand_id IS NULL AND comment_id IS NULL)
  OR (host_kind = 'comment' AND host_record_id IS NOT NULL AND comment_id IS NOT NULL)
  OR (host_kind = 'document' AND host_record_id IS NOT NULL AND comment_id IS NULL)
  OR (host_kind IN ('brand', 'project', 'task') AND host_record_id IS NOT NULL AND comment_id IS NULL
      AND brand_id IS NOT NULL));
ALTER TABLE files.upload_session DROP CONSTRAINT upload_session_host_kind_known;
ALTER TABLE files.upload_session ADD CONSTRAINT upload_session_host_kind_known
  CHECK (host_kind IN ('workspace', 'brand', 'project', 'task', 'comment', 'document'));

-- ---------------------------------------------------------------------------------------------
-- Draft: at most one per document. `seq` is the last sequenced operation (gapless, monotonic
-- through the life of the document; checkpoints never reset it); `dirty` is true while the draft
-- holds operations no version contains.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge.edit_draft (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  base_version integer NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  seq bigint NOT NULL DEFAULT 0,
  checkpoint_seq bigint NOT NULL DEFAULT 0,
  dirty boolean NOT NULL DEFAULT false,
  last_editor_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edit_draft_pkey PRIMARY KEY (workspace_id, document_id),
  CONSTRAINT edit_draft_document_fkey FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge.document (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT edit_draft_editor_fkey FOREIGN KEY (workspace_id, last_editor_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT edit_draft_content CHECK (knowledge.valid_content(content)),
  CONSTRAINT edit_draft_hash_format CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT edit_draft_base CHECK (base_version >= 1),
  CONSTRAINT edit_draft_seq CHECK (seq >= 0 AND checkpoint_seq >= 0 AND checkpoint_seq <= seq)
);
CREATE INDEX edit_draft_by_editor ON knowledge.edit_draft (workspace_id, last_editor_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Sessions: explicit lifecycle, ephemeral. `session_key` is an unguessable client handle (not an
-- identifier of any record). A session past `expires_at` is stale and is swept. Presence is the
-- colour index and the block the person is in; never text.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge.edit_session (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  session_key text NOT NULL,
  mode text NOT NULL DEFAULT 'edit',
  color smallint NOT NULL DEFAULT 0,
  caret_block text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT edit_session_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT edit_session_key_unique UNIQUE (workspace_id, document_id, session_key),
  CONSTRAINT edit_session_document_fkey FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge.document (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT edit_session_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT edit_session_key_format CHECK (session_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  CONSTRAINT edit_session_mode_known CHECK (mode IN ('edit', 'view')),
  CONSTRAINT edit_session_color CHECK (color BETWEEN 0 AND 15),
  CONSTRAINT edit_session_caret CHECK (caret_block IS NULL OR char_length(caret_block) BETWEEN 1 AND 64)
);
CREATE INDEX edit_session_live ON knowledge.edit_session (workspace_id, document_id, expires_at);
CREATE INDEX edit_session_by_member ON knowledge.edit_session (workspace_id, membership_id, expires_at);
CREATE INDEX edit_session_expiry ON knowledge.edit_session (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Operations: the ordered log of accepted operations since the retained window starts. Rejected
-- (conflicting) operations are never stored. `op_id` makes a retry idempotent.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge.edit_op (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  document_id uuid NOT NULL,
  seq bigint NOT NULL,
  session_id uuid,
  membership_id uuid NOT NULL,
  op_id text NOT NULL,
  kind text NOT NULL,
  block_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edit_op_pkey PRIMARY KEY (workspace_id, document_id, seq),
  CONSTRAINT edit_op_document_fkey FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge.document (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT edit_op_member_fkey FOREIGN KEY (workspace_id, membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT edit_op_session_fkey FOREIGN KEY (workspace_id, session_id)
    REFERENCES knowledge.edit_session (workspace_id, id) ON DELETE SET NULL (session_id),
  CONSTRAINT edit_op_kind_known CHECK (kind IN ('insert', 'replace', 'delete', 'move')),
  CONSTRAINT edit_op_op_id CHECK (char_length(op_id) BETWEEN 1 AND 64),
  CONSTRAINT edit_op_block CHECK (char_length(block_id) BETWEEN 1 AND 64),
  CONSTRAINT edit_op_payload CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 200000),
  CONSTRAINT edit_op_seq CHECK (seq >= 1)
);
CREATE UNIQUE INDEX edit_op_idempotency ON knowledge.edit_op (workspace_id, document_id, membership_id, op_id);
CREATE INDEX edit_op_by_member ON knowledge.edit_op (workspace_id, membership_id);
CREATE INDEX edit_op_by_session ON knowledge.edit_op (workspace_id, session_id);

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE knowledge.edit_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.edit_draft FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge.edit_draft
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE knowledge.edit_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.edit_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge.edit_session
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE knowledge.edit_op ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.edit_op FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge.edit_op
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON knowledge.edit_draft, knowledge.edit_session, knowledge.edit_op FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON knowledge.edit_draft TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge.edit_session TO app_rw;
GRANT SELECT, INSERT, DELETE ON knowledge.edit_op TO app_rw;
-- The worker sweeps expired sessions and purges a purged document's drafts and logs, nothing else.
GRANT SELECT, DELETE ON knowledge.edit_draft, knowledge.edit_session, knowledge.edit_op TO app_worker;
