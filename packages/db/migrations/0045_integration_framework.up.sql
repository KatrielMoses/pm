-- migrate:phase expand
-- Phase 6A (0B ADR-40, 0C AZ-40, 0D PL-42): provider-neutral connections, encrypted credential
-- references, sync checkpoints, runs, deliveries, and conflicts. Credentials never live in these
-- tables: a row holds a vault reference only. Disconnect always destroys that reference.

CREATE SCHEMA integrations;
REVOKE ALL ON SCHEMA integrations FROM PUBLIC;
GRANT USAGE ON SCHEMA integrations TO app_rw, app_worker;

-- The development vault records which key wrapped a secret so a later key can still read it.
ALTER TABLE ops.dev_secret_vault
  ADD COLUMN key_id smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT dev_secret_vault_key_id CHECK (key_id BETWEEN 1 AND 32);

-- ---------------------------------------------------------------------------------------------
-- Connections (INT-001..INT-009, INT-004, PERM-009, WSB-013). A connection is a core record.
-- Workspace-scoped rows have no brand; brand-scoped rows name one brand. The credential column
-- is a reference, never a secret.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.connection (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  scope_key uuid NOT NULL,
  lifecycle_state core.lifecycle_state NOT NULL DEFAULT 'active',
  provider text NOT NULL,
  auth_kind text NOT NULL,
  display_name text NOT NULL,
  owner_membership_id uuid NOT NULL,
  granted_scopes text[] NOT NULL,
  health text NOT NULL DEFAULT 'needs_reauthorization',
  credential_secret_ref text,
  credential_key_version integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_error text,
  suspended_reason text,
  suspended_at timestamptz,
  outbound_paused boolean NOT NULL DEFAULT false,
  retention_choice text,
  disconnected_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id uuid,
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT connection_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT connection_scope_key UNIQUE (workspace_id, scope_key, id),
  CONSTRAINT connection_scope_shape CHECK (scope_key = coalesce(brand_id, workspace_id)),
  CONSTRAINT connection_envelope_fkey FOREIGN KEY (id, workspace_id, scope_key, lifecycle_state)
    REFERENCES core.record (id, workspace_id, scope_key, lifecycle_state)
    ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT connection_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_owner_fkey FOREIGN KEY (workspace_id, owner_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT connection_provider_known CHECK (provider IN ('loopback', 'google_calendar', 'github', 'email_inbound')),
  CONSTRAINT connection_auth_known CHECK (auth_kind IN ('oauth', 'api_key')),
  CONSTRAINT connection_name_text CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120
    AND display_name = btrim(display_name) AND tenancy.valid_plain_text(display_name, 120)),
  CONSTRAINT connection_scopes_shape CHECK (
    cardinality(granted_scopes) BETWEEN 1 AND 16
    AND granted_scopes::text ~ '^\{([a-z][a-z0-9._]{0,40})(,[a-z][a-z0-9._]{0,40})*\}$'),
  CONSTRAINT connection_health_known CHECK (health IN
    ('connected', 'needs_reauthorization', 'error', 'disconnected', 'provider_unconfigured', 'degraded')),
  CONSTRAINT connection_secret_ref CHECK (credential_secret_ref IS NULL
    OR credential_secret_ref ~ '^dev:[a-z_]+:[0-9a-f]{32}$'),
  CONSTRAINT connection_key_version CHECK (credential_key_version >= 0),
  CONSTRAINT connection_error_code CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$'),
  CONSTRAINT connection_suspended_known CHECK (suspended_reason IS NULL
    OR suspended_reason IN ('owner_authority', 'owner_departed', 'admin')),
  CONSTRAINT connection_suspended_shape CHECK ((suspended_reason IS NULL) = (suspended_at IS NULL)),
  CONSTRAINT connection_retention_known CHECK (retention_choice IS NULL OR retention_choice IN ('retain', 'remove')),
  CONSTRAINT connection_disconnect_shape CHECK ((health = 'disconnected') = (disconnected_at IS NOT NULL)
    AND (health <> 'disconnected' OR retention_choice IS NOT NULL)),
  CONSTRAINT connection_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX connection_by_envelope ON integrations.connection (id, workspace_id, scope_key, lifecycle_state);
CREATE INDEX connection_by_scope ON integrations.connection (workspace_id, scope_key, id);
CREATE INDEX connection_by_brand ON integrations.connection (workspace_id, brand_id);
CREATE INDEX connection_by_owner ON integrations.connection (workspace_id, owner_membership_id);
CREATE INDEX connection_by_creator ON integrations.connection (workspace_id, created_by_membership_id);
CREATE INDEX connection_by_updater ON integrations.connection (workspace_id, updated_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Checkpoints advance by compare-and-set (one cursor per connection and resource).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.sync_checkpoint (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  resource_key text NOT NULL,
  cursor text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_checkpoint_pkey PRIMARY KEY (workspace_id, connection_id, resource_key),
  CONSTRAINT sync_checkpoint_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_checkpoint_resource CHECK (resource_key ~ '^[a-z0-9_.:-]{1,80}$'),
  CONSTRAINT sync_checkpoint_cursor CHECK (char_length(cursor) BETWEEN 1 AND 500),
  CONSTRAINT sync_checkpoint_version CHECK (version >= 0)
);
CREATE INDEX sync_checkpoint_by_connection ON integrations.sync_checkpoint (workspace_id, connection_id);

-- ---------------------------------------------------------------------------------------------
-- External identities (INT-023): the sync identity of an external object. Labels are not secrets.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.external_identity (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  external_type text NOT NULL,
  external_id text NOT NULL,
  label text NOT NULL,
  record_id uuid,
  remote_version text NOT NULL,
  local_version text NOT NULL,
  base_version text NOT NULL,
  detached boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_identity_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT external_identity_public_key UNIQUE (public_id),
  CONSTRAINT external_identity_public_format CHECK (public_id ~ '^ext_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT external_identity_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT external_identity_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT external_identity_pair UNIQUE (workspace_id, connection_id, external_type, external_id),
  CONSTRAINT external_identity_type CHECK (external_type ~ '^[a-z][a-z0-9_]{0,30}$'),
  CONSTRAINT external_identity_external CHECK (char_length(external_id) BETWEEN 1 AND 200),
  CONSTRAINT external_identity_label CHECK (char_length(btrim(label)) BETWEEN 1 AND 200
    AND tenancy.valid_plain_text(label, 200)),
  CONSTRAINT external_identity_versions CHECK (
    char_length(remote_version) BETWEEN 1 AND 80
    AND char_length(local_version) BETWEEN 1 AND 80
    AND char_length(base_version) BETWEEN 1 AND 80)
);
CREATE INDEX external_identity_by_connection ON integrations.external_identity (workspace_id, connection_id);
CREATE INDEX external_identity_by_record ON integrations.external_identity (workspace_id, record_id);

-- ---------------------------------------------------------------------------------------------
-- One sync attempt. History is kept when synchronized data is removed (event history).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.sync_run (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  idempotency_key text,
  direction text NOT NULL,
  state text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  failure_class text,
  error_code text,
  read_count integer NOT NULL DEFAULT 0,
  write_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT sync_run_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_run_direction CHECK (direction IN ('inbound', 'outbound', 'test')),
  CONSTRAINT sync_run_state_known CHECK (state IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'dead', 'skipped')),
  CONSTRAINT sync_run_attempt CHECK (attempt >= 1),
  CONSTRAINT sync_run_counts CHECK (read_count >= 0 AND write_count >= 0 AND conflict_count >= 0),
  CONSTRAINT sync_run_failure_known CHECK (failure_class IS NULL
    OR failure_class IN ('transient', 'permanent', 'unconfigured', 'degraded')),
  CONSTRAINT sync_run_error_code CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,40}$'),
  CONSTRAINT sync_run_key_shape CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 200)
);
CREATE UNIQUE INDEX sync_run_idempotency ON integrations.sync_run (workspace_id, connection_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX sync_run_by_connection ON integrations.sync_run (workspace_id, connection_id, started_at);
CREATE INDEX sync_run_by_started ON integrations.sync_run (workspace_id, started_at);

-- ---------------------------------------------------------------------------------------------
-- At-least-once delivery. A dedupe key makes a repeated sync a no-op; exhausted attempts dead-letter.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.sync_delivery (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  dedupe_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failure_class text,
  error_code text,
  payload_hash text,
  claimed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_delivery_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_delivery_dedupe UNIQUE (workspace_id, connection_id, dedupe_key),
  CONSTRAINT sync_delivery_state_known CHECK (state IN ('pending', 'delivered', 'retry_scheduled', 'dead')),
  CONSTRAINT sync_delivery_attempts CHECK (attempts >= 0),
  CONSTRAINT sync_delivery_key CHECK (char_length(dedupe_key) BETWEEN 8 AND 200),
  CONSTRAINT sync_delivery_failure_known CHECK (failure_class IS NULL
    OR failure_class IN ('transient', 'permanent', 'unconfigured', 'degraded')),
  CONSTRAINT sync_delivery_error_code CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,40}$'),
  CONSTRAINT sync_delivery_hash CHECK (payload_hash IS NULL OR payload_hash ~ '^sha256:[0-9a-f]{64}$')
);
CREATE INDEX sync_delivery_by_connection ON integrations.sync_delivery (workspace_id, connection_id);
CREATE INDEX sync_delivery_due ON integrations.sync_delivery (workspace_id, next_attempt_at)
  WHERE state IN ('pending', 'retry_scheduled');

-- ---------------------------------------------------------------------------------------------
-- Conflicts (INT-024, INT-025). Digests and versions only; field values are not stored.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integrations.sync_conflict (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL,
  external_identity_id uuid NOT NULL,
  field_key text NOT NULL,
  local_version text NOT NULL,
  remote_version text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  resolved_by_membership_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT sync_conflict_public_key UNIQUE (public_id),
  CONSTRAINT sync_conflict_public_format CHECK (public_id ~ '^cnf_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT sync_conflict_connection_fkey FOREIGN KEY (workspace_id, connection_id)
    REFERENCES integrations.connection (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_conflict_identity_fkey FOREIGN KEY (workspace_id, external_identity_id)
    REFERENCES integrations.external_identity (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_conflict_resolver_fkey FOREIGN KEY (workspace_id, resolved_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sync_conflict_field CHECK (field_key ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT sync_conflict_versions CHECK (char_length(local_version) BETWEEN 1 AND 80
    AND char_length(remote_version) BETWEEN 1 AND 80),
  CONSTRAINT sync_conflict_state_known CHECK (state IN ('open', 'kept_local', 'kept_remote', 'dismissed')),
  CONSTRAINT sync_conflict_resolved_shape CHECK ((state = 'open') = (resolved_at IS NULL)
    AND (state = 'open') = (resolved_by_membership_id IS NULL)),
  CONSTRAINT sync_conflict_version CHECK (version >= 0)
);
CREATE UNIQUE INDEX sync_conflict_open ON integrations.sync_conflict (workspace_id, external_identity_id, field_key)
  WHERE state = 'open';
CREATE INDEX sync_conflict_by_connection ON integrations.sync_conflict (workspace_id, connection_id);
CREATE INDEX sync_conflict_by_identity ON integrations.sync_conflict (workspace_id, external_identity_id);
CREATE INDEX sync_conflict_by_resolver ON integrations.sync_conflict (workspace_id, resolved_by_membership_id);

-- Search: a connection's name and provider, never its credential or scopes.
CREATE FUNCTION search.connection_changed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO search.index_status (workspace_id, source_kind, source_id, auth_record_id)
  VALUES (NEW.workspace_id, 'connection', NEW.id, NEW.id)
  ON CONFLICT (workspace_id, source_kind, source_id) DO UPDATE
    SET auth_record_id = EXCLUDED.auth_record_id, state = 'pending', attempts = 0,
        requested_at = now(), next_attempt_at = now(), failure_code = NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER search_changed AFTER INSERT OR UPDATE OF display_name, provider, health
  ON integrations.connection
  FOR EACH ROW EXECUTE FUNCTION search.connection_changed();
CREATE TRIGGER search_removed AFTER DELETE ON integrations.connection
  FOR EACH ROW EXECUTE FUNCTION search.source_removed();

-- Worker discovery (payload-free): workspaces with a delivery due, or sync history past retention.
CREATE POLICY scheduler_discovery ON integrations.sync_delivery FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, next_attempt_at, state) ON integrations.sync_delivery TO pm_scheduler;
CREATE POLICY scheduler_discovery ON integrations.sync_run FOR SELECT TO pm_scheduler USING (true);
GRANT SELECT (workspace_id, started_at) ON integrations.sync_run TO pm_scheduler;
GRANT USAGE ON SCHEMA integrations TO pm_scheduler;

CREATE FUNCTION exec_dispatch.discover_integration_work(p_now timestamptz, p_retention_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.workspace_id FROM (
    SELECT d.workspace_id, d.next_attempt_at AS due FROM integrations.sync_delivery d
     WHERE d.state IN ('pending', 'retry_scheduled') AND d.next_attempt_at <= p_now
    UNION ALL
    SELECT r.workspace_id, min(r.started_at) FROM integrations.sync_run r
     WHERE r.started_at < p_retention_before GROUP BY r.workspace_id
  ) w
   GROUP BY w.workspace_id
   ORDER BY min(w.due), w.workspace_id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION exec_dispatch.discover_integration_work(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec_dispatch.discover_integration_work(timestamptz, timestamptz, integer) TO dispatcher;
ALTER FUNCTION exec_dispatch.discover_integration_work(timestamptz, timestamptz, integer) OWNER TO pm_scheduler;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE integrations.connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.connection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.connection
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.sync_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.sync_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.sync_checkpoint
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.external_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.external_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.external_identity
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.sync_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.sync_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.sync_run
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.sync_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.sync_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.sync_delivery
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE integrations.sync_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations.sync_conflict FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integrations.sync_conflict
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON integrations.connection, integrations.sync_checkpoint, integrations.external_identity,
  integrations.sync_run, integrations.sync_delivery, integrations.sync_conflict FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON integrations.connection TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.sync_checkpoint, integrations.external_identity,
  integrations.sync_run, integrations.sync_delivery, integrations.sync_conflict TO app_rw;
GRANT SELECT, UPDATE, DELETE ON integrations.connection TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations.sync_checkpoint, integrations.external_identity,
  integrations.sync_run, integrations.sync_delivery, integrations.sync_conflict TO app_worker;
