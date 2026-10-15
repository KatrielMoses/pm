-- migrate:phase expand
-- Phase 6D: bounded, tenant-isolated import provenance and resumable row checkpoints.
-- The 6B discovery function also filters claimed_until; its owner requires this column grant.
GRANT SELECT (claimed_until) ON integrations.webhook_delivery TO pm_scheduler;
CREATE SCHEMA transfer;
REVOKE ALL ON SCHEMA transfer FROM PUBLIC;
GRANT USAGE ON SCHEMA transfer TO app_rw;
GRANT USAGE ON SCHEMA transfer TO app_worker;

CREATE TABLE transfer.import_job (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  preview_id uuid,
  mapping_id uuid,
  mapping_version integer,
  schema_version text NOT NULL DEFAULT '1',
  content_sha256 bytea NOT NULL,
  request_key_sha256 bytea NOT NULL,
  entity_kind text NOT NULL,
  state text NOT NULL DEFAULT 'previewed',
  apply_mode text NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  applied_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  checkpoint_row integer NOT NULL DEFAULT 0,
  rollback_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_job_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT import_job_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT import_job_digest_length CHECK (octet_length(content_sha256) = 32),
  CONSTRAINT import_job_request_key_length CHECK (octet_length(request_key_sha256) = 32),
  CONSTRAINT import_job_entity CHECK (entity_kind IN ('task', 'project', 'workflow', 'field', 'goal', 'document', 'file')),
  CONSTRAINT import_job_mapping_version CHECK ((mapping_id IS NULL) = (mapping_version IS NULL) AND (mapping_version IS NULL OR mapping_version > 0)),
  CONSTRAINT import_job_schema CHECK (schema_version = '1'),
  CONSTRAINT import_job_state CHECK (state IN ('previewed', 'running', 'partial', 'completed', 'failed', 'rolled_back')),
  CONSTRAINT import_job_mode CHECK (apply_mode IN ('partial', 'all_or_nothing')),
  CONSTRAINT import_job_counts CHECK (row_count BETWEEN 0 AND 2000 AND applied_count BETWEEN 0 AND row_count AND error_count BETWEEN 0 AND row_count AND (checkpoint_row = 0 OR checkpoint_row BETWEEN 2 AND row_count + 1))
);
CREATE UNIQUE INDEX import_job_dedupe ON transfer.import_job (workspace_id, owner_membership_id, content_sha256, entity_kind, apply_mode)
  WHERE state IN ('previewed', 'running', 'partial', 'completed');
CREATE UNIQUE INDEX import_job_request_key ON transfer.import_job (workspace_id, owner_membership_id, request_key_sha256)
  WHERE state <> 'rolled_back';
CREATE INDEX import_job_recovery ON transfer.import_job (workspace_id, state, updated_at);
CREATE INDEX import_job_owner_fk ON transfer.import_job (workspace_id, owner_membership_id);
CREATE INDEX import_job_preview_fk ON transfer.import_job (workspace_id, preview_id);
CREATE UNIQUE INDEX import_job_one_running_per_owner ON transfer.import_job (workspace_id, owner_membership_id)
  WHERE state = 'running';

-- A saved mapping is a private convenience owned by one membership. It contains only a
-- source-column to allowlisted portable-field map; it never carries authorization context.
CREATE TABLE transfer.import_mapping (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  name text NOT NULL,
  entity_kind text NOT NULL,
  schema_version text NOT NULL DEFAULT '1',
  mapping_version integer NOT NULL DEFAULT 1,
  column_mapping jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_mapping_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT import_mapping_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT import_mapping_entity CHECK (entity_kind IN ('task', 'project', 'workflow', 'field', 'goal', 'document', 'file')),
  CONSTRAINT import_mapping_name CHECK (length(name) BETWEEN 1 AND 80),
  CONSTRAINT import_mapping_schema CHECK (schema_version = '1'),
  CONSTRAINT import_mapping_version CHECK (mapping_version > 0),
  CONSTRAINT import_mapping_size CHECK (octet_length(column_mapping::text) <= 16384)
);
CREATE UNIQUE INDEX import_mapping_owner_name ON transfer.import_mapping
  (workspace_id, owner_membership_id, lower(name));

CREATE TABLE transfer.import_row (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  import_job_id uuid NOT NULL,
  row_number integer NOT NULL,
  source_row_key text,
  source_values jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  record_type text,
  record_id uuid,
  record_public_id text,
  applied_version bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, import_job_id, row_number),
  CONSTRAINT import_row_job_fkey FOREIGN KEY (workspace_id, import_job_id)
    REFERENCES transfer.import_job (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT import_row_number CHECK (row_number BETWEEN 2 AND 2001),
  CONSTRAINT import_row_state CHECK (state IN ('pending', 'applied', 'error', 'rolled_back', 'conflict')),
  CONSTRAINT import_row_source_size CHECK (octet_length(source_values::text) <= 131072),
  CONSTRAINT import_row_record_pair CHECK ((record_type IS NULL) = (record_public_id IS NULL))
);
CREATE UNIQUE INDEX import_row_source_key ON transfer.import_row (workspace_id, import_job_id, source_row_key)
  WHERE source_row_key IS NOT NULL;

CREATE TABLE transfer.import_preview (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  owner_membership_id uuid NOT NULL,
  entity_kind text NOT NULL,
  content_sha256 bytea NOT NULL,
  schema_version text NOT NULL DEFAULT '1',
  mapping_id uuid,
  mapping_version integer,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_preview_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT import_preview_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT import_preview_entity CHECK (entity_kind IN ('task', 'project', 'workflow', 'field', 'goal', 'document', 'file')),
  CONSTRAINT import_preview_digest_length CHECK (octet_length(content_sha256) = 32),
  CONSTRAINT import_preview_schema CHECK (schema_version = '1'),
  CONSTRAINT import_preview_mapping_version CHECK ((mapping_id IS NULL) = (mapping_version IS NULL) AND (mapping_version IS NULL OR mapping_version > 0))
);
CREATE INDEX import_preview_expiry ON transfer.import_preview (workspace_id, expires_at);
CREATE INDEX import_preview_owner_fk ON transfer.import_preview (workspace_id, owner_membership_id);
ALTER TABLE transfer.import_job ADD CONSTRAINT import_job_preview_fkey
  FOREIGN KEY (workspace_id, preview_id) REFERENCES transfer.import_preview (workspace_id, id) ON DELETE CASCADE;

ALTER TABLE transfer.import_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer.import_job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transfer.import_job
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
ALTER TABLE transfer.import_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer.import_row FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transfer.import_row
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
ALTER TABLE transfer.import_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer.import_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transfer.import_mapping
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
ALTER TABLE transfer.import_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer.import_preview FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transfer.import_preview
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);
REVOKE ALL ON transfer.import_job, transfer.import_row, transfer.import_mapping, transfer.import_preview FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON transfer.import_job, transfer.import_row, transfer.import_mapping, transfer.import_preview TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON transfer.import_job, transfer.import_row TO app_worker;
GRANT SELECT, DELETE ON transfer.import_preview, transfer.import_mapping TO app_worker;
